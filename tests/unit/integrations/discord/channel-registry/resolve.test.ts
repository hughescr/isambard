import { describe, test, expect, beforeEach } from 'bun:test';
import type { ChannelRegistryManager } from '../../../../../src/integrations/discord/channel-registry/manager';
import { resolveChannelId } from '../../../../../src/integrations/discord/channel-registry/resolve';
import type { ChannelMetadata } from '../../../../../src/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '../../../../../src/integrations/discord/types';
import { ChannelNotFoundByNameError } from '@/errors';

describe('resolveChannelId', () => {
    let mockRegistry: ChannelRegistryManager;
    const testChannelId = createChannelId('1451694737026449581');
    const testChannelId2 = createChannelId('9876543210987654321');

    beforeEach(() => {
        // Create mock registry with test channels
        const now = new Date().toISOString();
        const testGuildId = createGuildId('123');
        const channels: ChannelMetadata[] = [
            {
                channelId:    testChannelId,
                channelName:  'general',
                guildId:      testGuildId,
                isMuted:      false,
                isWellKnown:  'general' as const,
                discoveredAt: now,
                lastSeenAt:   now,
                updatedAt:    now,
            },
            {
                channelId:    testChannelId2,
                channelName:  'off-topic',
                guildId:      testGuildId,
                isMuted:      false,
                discoveredAt: now,
                lastSeenAt:   now,
                updatedAt:    now,
            },
        ];

        mockRegistry = {
            getAllChannels: () => channels,
        } as unknown as ChannelRegistryManager;
    });

    describe('channel name resolution (#channel-name format)', () => {
        test('should resolve #general to channel ID', () => {
            const result = resolveChannelId('#general', mockRegistry);
            expect(result).toBe(testChannelId);
        });

        test('should resolve #off-topic to channel ID', () => {
            const result = resolveChannelId('#off-topic', mockRegistry);
            expect(result).toBe(testChannelId2);
        });

        test('should throw ChannelNotFoundByNameError for non-existent channel name', () => {
            expect(() => {
                resolveChannelId('#nonexistent', mockRegistry);
            }).toThrow(ChannelNotFoundByNameError);
            expect(() => {
                resolveChannelId('#nonexistent', mockRegistry);
            }).toThrow('Channel not found: nonexistent');
        });

        test('should throw ChannelNotFoundByNameError for empty channel name after #', () => {
            expect(() => {
                resolveChannelId('#', mockRegistry);
            }).toThrow(ChannelNotFoundByNameError);
            expect(() => {
                resolveChannelId('#', mockRegistry);
            }).toThrow('Channel not found: ');
        });

        test('should handle channel names with dashes', () => {
            const result = resolveChannelId('#off-topic', mockRegistry);
            expect(result).toBe(testChannelId2);
        });
    });

    describe('numeric ID pass-through', () => {
        test('should pass through numeric channel ID unchanged', () => {
            const numericId = '1451694737026449581';
            const result = resolveChannelId(numericId, mockRegistry);
            expect(result).toBe(createChannelId(numericId));
        });

        test('should pass through numeric ID even if it does not exist in registry', () => {
            const unknownId = '9999999999999999999';
            const result = resolveChannelId(unknownId, mockRegistry);
            expect(result).toBe(createChannelId(unknownId));
        });

        test('should reject empty string with validation error', () => {
            // resolveChannelId now validates at creation time via createChannelId
            // Empty strings are rejected with a ZodError
            expect(() => resolveChannelId('', mockRegistry)).toThrow('Channel ID cannot be empty');
        });

        test('should handle string starting with number but not pure numeric', () => {
            // This would be treated as a numeric ID (no # prefix)
            const result = resolveChannelId('123abc', mockRegistry);
            expect(result).toBe(createChannelId('123abc'));
        });
    });

    describe('edge cases', () => {
        test('should not match partial channel name', () => {
            expect(() => {
                resolveChannelId('#gen', mockRegistry);
            }).toThrow(ChannelNotFoundByNameError);
            expect(() => {
                resolveChannelId('#gen', mockRegistry);
            }).toThrow('Channel not found: gen');
        });

        test('should be case-sensitive for channel names', () => {
            expect(() => {
                resolveChannelId('#General', mockRegistry);
            }).toThrow(ChannelNotFoundByNameError);
            expect(() => {
                resolveChannelId('#General', mockRegistry);
            }).toThrow('Channel not found: General');
        });

        test('should handle registry with no channels', () => {
            const emptyRegistry = {
                getAllChannels: () => [],
            } as unknown as ChannelRegistryManager;

            expect(() => {
                resolveChannelId('#general', emptyRegistry);
            }).toThrow(ChannelNotFoundByNameError);
            expect(() => {
                resolveChannelId('#general', emptyRegistry);
            }).toThrow('Channel not found: general');
        });

        test('should handle registry with duplicate channel names (returns first match)', () => {
            const now = new Date().toISOString();
            const duplicateChannels: ChannelMetadata[] = [
                {
                    channelId:    testChannelId,
                    channelName:  'duplicate',
                    guildId:      createGuildId('123'),
                    isMuted:      false,
                    discoveredAt: now,
                    lastSeenAt:   now,
                    updatedAt:    now,
                },
                {
                    channelId:    testChannelId2,
                    channelName:  'duplicate',
                    guildId:      createGuildId('456'),
                    isMuted:      false,
                    discoveredAt: now,
                    lastSeenAt:   now,
                    updatedAt:    now,
                },
            ];

            const duplicateRegistry = {
                getAllChannels: () => duplicateChannels,
            } as unknown as ChannelRegistryManager;

            // Should return first match
            const result = resolveChannelId('#duplicate', duplicateRegistry);
            expect(result).toBe(testChannelId);
        });
    });
});
