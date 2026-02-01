import { describe, it, expect, beforeEach } from 'bun:test';
import _ from 'lodash';
import { normalizeChannelName, formatChannelReference, ChannelNameResolver } from '../../../../../src/integrations/discord/channel-registry/name-resolver';
import type { ChannelRegistryManager } from '../../../../../src/integrations/discord/channel-registry/manager';
import type { ChannelReference, ChannelMetadata } from '../../../../../src/integrations/discord/channel-registry/types';
import { ChannelNotFoundError, AmbiguousChannelError } from '../../../../../src/integrations/discord/channel-registry/errors';
import { createChannelId, createGuildId } from '../../../../../src/integrations/discord/types';
import type { GuildId } from '../../../../../src/integrations/discord/types';

describe('normalizeChannelName', () => {
    it('should strip # prefix from channel names', () => {
        expect(normalizeChannelName('#general')).toBe('general');
    });

    it('should handle names without # prefix', () => {
        expect(normalizeChannelName('general')).toBe('general');
    });

    it('should strip # prefix from DM channel names', () => {
        expect(normalizeChannelName('#DM - alice')).toBe('DM - alice');
    });

    it('should strip @ prefix from DM usernames', () => {
        expect(normalizeChannelName('#DM - @alice')).toBe('DM - alice');
    });

    it('should handle DM without # prefix but with @ prefix', () => {
        expect(normalizeChannelName('DM - @alice')).toBe('DM - alice');
    });

    it('should handle DM without any prefix', () => {
        expect(normalizeChannelName('DM - alice')).toBe('DM - alice');
    });

    it('should handle empty string after # prefix', () => {
        expect(normalizeChannelName('#')).toBe('');
    });

    it('should handle multiple # prefixes', () => {
        expect(normalizeChannelName('##channel')).toBe('#channel');
    });
});

describe('formatChannelReference', () => {
    it('should format channel reference without guild name', () => {
        const ref: ChannelReference = {
            channelName: 'general',
            guildName:   undefined,
            channelId:   createChannelId('123'),
            guildId:     createGuildId('456'),
        };
        expect(formatChannelReference(ref)).toBe('#general');
    });

    it('should format channel reference with guild name', () => {
        const ref: ChannelReference = {
            channelName: 'general',
            guildName:   'My Server',
            channelId:   createChannelId('123'),
            guildId:     createGuildId('456'),
        };
        expect(formatChannelReference(ref)).toBe('#general (My Server)');
    });

    it('should format DM channel reference without guild name', () => {
        const ref: ChannelReference = {
            channelName: 'DM - alice',
            guildName:   undefined,
            channelId:   createChannelId('123'),
            guildId:     'DM',
        };
        expect(formatChannelReference(ref)).toBe('#DM - alice');
    });

    it('should handle empty channel name', () => {
        const ref: ChannelReference = {
            channelName: '',
            guildName:   undefined,
            channelId:   createChannelId('123'),
            guildId:     createGuildId('456'),
        };
        expect(formatChannelReference(ref)).toBe('#');
    });

    it('should handle special characters in channel name', () => {
        const ref: ChannelReference = {
            channelName: 'general-🚀',
            guildName:   undefined,
            channelId:   createChannelId('123'),
            guildId:     createGuildId('456'),
        };
        expect(formatChannelReference(ref)).toBe('#general-🚀');
    });

    it('should handle special characters in guild name', () => {
        const ref: ChannelReference = {
            channelName: 'general',
            guildName:   'Server (Test)',
            channelId:   createChannelId('123'),
            guildId:     createGuildId('456'),
        };
        expect(formatChannelReference(ref)).toBe('#general (Server (Test))');
    });
});

describe('ChannelNameResolver', () => {
    let mockManager: ChannelRegistryManager;
    let resolver: ChannelNameResolver;

    beforeEach(() => {
        // Create a mock manager with minimal implementation
        mockManager = {
            resolveByName: _.constant(Promise.resolve([])),
            getChannel:    _.constant(Promise.resolve(null)),
        } as unknown as ChannelRegistryManager;

        resolver = new ChannelNameResolver(mockManager);
    });

    describe('resolveToId', () => {
        it('should resolve a single matching channel', async () => {
            const expectedId = createChannelId('123');
            const mockReferences: ChannelReference[] = [{
                channelName: 'general',
                guildName:   undefined,
                channelId:   expectedId,
                guildId:     createGuildId('456'),
            }];

            mockManager.resolveByName = async () => mockReferences;

            const result = await resolver.resolveToId('#general');
            expect(result).toBe(expectedId);
        });

        it('should normalize channel name before resolving', async () => {
            const expectedId = createChannelId('123');
            const mockReferences: ChannelReference[] = [{
                channelName: 'general',
                guildName:   undefined,
                channelId:   expectedId,
                guildId:     createGuildId('456'),
            }];

            let capturedName: string | undefined;
            mockManager.resolveByName = async (name: string) => {
                capturedName = name;
                return mockReferences;
            };

            await resolver.resolveToId('#general');
            expect(capturedName).toBe('general');
        });

        it('should pass contextGuildId to manager', async () => {
            const expectedId = createChannelId('123');
            const contextGuildId = createGuildId('999');
            const mockReferences: ChannelReference[] = [{
                channelName: 'general',
                guildName:   undefined,
                channelId:   expectedId,
                guildId:     contextGuildId,
            }];

            let capturedGuildId: GuildId | undefined;
            mockManager.resolveByName = async (_name: string, guildId?: GuildId) => {
                capturedGuildId = guildId;
                return mockReferences;
            };

            await resolver.resolveToId('#general', contextGuildId);
            expect(capturedGuildId).toBe(contextGuildId);
        });

        it('should throw ChannelNotFoundError when no matches found', () => {
            mockManager.resolveByName = async () => [];

            return expect(resolver.resolveToId('#nonexistent')).rejects.toThrow(ChannelNotFoundError);
        });

        it('should include channel name in ChannelNotFoundError', async () => {
            mockManager.resolveByName = async () => [];

            try {
                await resolver.resolveToId('#nonexistent');
                throw new Error('Expected ChannelNotFoundError to be thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(ChannelNotFoundError);
                if(error instanceof ChannelNotFoundError) {
                    expect(error.channelName).toBe('#nonexistent');
                    expect(error.message).toContain('#nonexistent');
                }
            }
        });

        it('should throw AmbiguousChannelError when multiple matches found', () => {
            const mockReferences: ChannelReference[] = [
                {
                    channelName: 'general',
                    guildName:   'Server 1',
                    channelId:   createChannelId('123'),
                    guildId:     createGuildId('456'),
                },
                {
                    channelName: 'general',
                    guildName:   'Server 2',
                    channelId:   createChannelId('789'),
                    guildId:     createGuildId('012'),
                },
            ];

            mockManager.resolveByName = async () => mockReferences;

            return expect(resolver.resolveToId('#general')).rejects.toThrow(AmbiguousChannelError);
        });

        it('should include match count in AmbiguousChannelError', async () => {
            const mockReferences: ChannelReference[] = [
                {
                    channelName: 'general',
                    guildName:   'Server 1',
                    channelId:   createChannelId('123'),
                    guildId:     createGuildId('456'),
                },
                {
                    channelName: 'general',
                    guildName:   'Server 2',
                    channelId:   createChannelId('789'),
                    guildId:     createGuildId('012'),
                },
                {
                    channelName: 'general',
                    guildName:   'Server 3',
                    channelId:   createChannelId('345'),
                    guildId:     createGuildId('678'),
                },
            ];

            mockManager.resolveByName = async () => mockReferences;

            try {
                await resolver.resolveToId('#general');
                throw new Error('Expected AmbiguousChannelError to be thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AmbiguousChannelError);
                if(error instanceof AmbiguousChannelError) {
                    expect(error.matchCount).toBe(3);
                    expect(error.channelName).toBe('#general');
                    expect(error.message).toContain('3');
                }
            }
        });
    });

    describe('resolveToReferences', () => {
        it('should return all matching references', async () => {
            const mockReferences: ChannelReference[] = [
                {
                    channelName: 'general',
                    guildName:   'Server 1',
                    channelId:   createChannelId('123'),
                    guildId:     createGuildId('456'),
                },
                {
                    channelName: 'general',
                    guildName:   'Server 2',
                    channelId:   createChannelId('789'),
                    guildId:     createGuildId('012'),
                },
            ];

            mockManager.resolveByName = async () => mockReferences;

            const result = await resolver.resolveToReferences('#general');
            expect(result).toEqual(mockReferences);
        });

        it('should normalize channel name before resolving', async () => {
            const mockReferences: ChannelReference[] = [];

            let capturedName: string | undefined;
            mockManager.resolveByName = async (name: string) => {
                capturedName = name;
                return mockReferences;
            };

            await resolver.resolveToReferences('#general');
            expect(capturedName).toBe('general');
        });

        it('should pass contextGuildId to manager', async () => {
            const contextGuildId = createGuildId('999');
            const mockReferences: ChannelReference[] = [];

            let capturedGuildId: GuildId | undefined;
            mockManager.resolveByName = async (_name: string, guildId?: GuildId) => {
                capturedGuildId = guildId;
                return mockReferences;
            };

            await resolver.resolveToReferences('#general', contextGuildId);
            expect(capturedGuildId).toBe(contextGuildId);
        });

        it('should return empty array when no matches found', async () => {
            mockManager.resolveByName = async () => [];

            const result = await resolver.resolveToReferences('#nonexistent');
            expect(result).toEqual([]);
        });
    });

    describe('formatChannelId', () => {
        it('should format channel ID using channel metadata', async () => {
            const channelId = createChannelId('123');
            const mockChannel: ChannelMetadata = {
                channelId,
                guildId:      createGuildId('456'),
                channelName:  'general',
                isMuted:      false,
                discoveredAt: '2024-01-01T00:00:00Z',
                lastSeenAt:   '2024-01-01T00:00:00Z',
                updatedAt:    '2024-01-01T00:00:00Z',
            };

            mockManager.getChannel = async () => mockChannel;

            const result = await resolver.formatChannelId(channelId);
            expect(result).toBe('#general');
        });

        it('should handle DM channel names', async () => {
            const channelId = createChannelId('123');
            const mockChannel: ChannelMetadata = {
                channelId,
                guildId:      'DM',
                channelName:  'DM - alice',
                isMuted:      false,
                discoveredAt: '2024-01-01T00:00:00Z',
                lastSeenAt:   '2024-01-01T00:00:00Z',
                updatedAt:    '2024-01-01T00:00:00Z',
            };

            mockManager.getChannel = async () => mockChannel;

            const result = await resolver.formatChannelId(channelId);
            expect(result).toBe('#DM - alice');
        });

        it('should return unknown format when channel not found', async () => {
            const channelId = createChannelId('999');
            mockManager.getChannel = _.constant(Promise.resolve(null));

            const result = await resolver.formatChannelId(channelId);
            expect(result).toBe('#unknown-999');
        });

        it('should include channel ID in unknown format', async () => {
            const channelId = createChannelId('12345');
            mockManager.getChannel = _.constant(Promise.resolve(null));

            const result = await resolver.formatChannelId(channelId);
            expect(result).toContain('12345');
        });
    });
});
