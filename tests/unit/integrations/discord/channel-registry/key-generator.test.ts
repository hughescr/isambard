import { describe, it, expect } from 'bun:test';
import { ChannelRegistryKeyGenerator } from '@/integrations/discord/channel-registry/key-generator';

describe('ChannelRegistryKeyGenerator', () => {
    describe('createKeys', () => {
        it('should create correct keys for a basic channel', () => {
            const keys = ChannelRegistryKeyGenerator.createKeys('123456', '789012');

            expect(keys).toEqual({
                PK:     'CHANNEL#123456',
                SK:     'METADATA',
                GSI1PK: 'GUILD#789012',
                GSI1SK: 'CHANNEL#123456',
            });
        });

        it('should handle channel names with special characters', () => {
            const keys = ChannelRegistryKeyGenerator.createKeys('999', '888');

            expect(keys).toEqual({
                PK:     'CHANNEL#999',
                SK:     'METADATA',
                GSI1PK: 'GUILD#888',
                GSI1SK: 'CHANNEL#999',
            });
        });

        it('should handle long channel IDs', () => {
            const longChannelId = '1234567890123456789';
            const longGuildId = '9876543210987654321';
            const keys = ChannelRegistryKeyGenerator.createKeys(longChannelId, longGuildId);

            expect(keys.PK).toBe(`CHANNEL#${longChannelId}`);
            expect(keys.GSI1PK).toBe(`GUILD#${longGuildId}`);
            expect(keys.GSI1SK).toBe(`CHANNEL#${longChannelId}`);
        });

        it('should handle empty channel IDs', () => {
            const keys = ChannelRegistryKeyGenerator.createKeys('', '222');

            expect(keys.GSI1SK).toBe('CHANNEL#');
        });

        it('should not include GSI2 keys', () => {
            const keys = ChannelRegistryKeyGenerator.createKeys('123', '456');

            expect(keys.GSI2PK).toBeUndefined();
            expect(keys.GSI2SK).toBeUndefined();
        });
    });

    describe('createWellKnownKeys', () => {
        it('should create correct GSI2 keys for catch-up channel', () => {
            const keys = ChannelRegistryKeyGenerator.createWellKnownKeys('catch-up');

            expect(keys).toEqual({
                GSI2PK: 'WELLKNOWN#catch-up',
                GSI2SK: 'CHANNEL',
            });
        });

        it('should create correct GSI2 keys for dev-chat channel', () => {
            const keys = ChannelRegistryKeyGenerator.createWellKnownKeys('dev-chat');

            expect(keys).toEqual({
                GSI2PK: 'WELLKNOWN#dev-chat',
                GSI2SK: 'CHANNEL',
            });
        });

        it('should handle arbitrary well-known types', () => {
            const keys = ChannelRegistryKeyGenerator.createWellKnownKeys('custom-type');

            expect(keys).toEqual({
                GSI2PK: 'WELLKNOWN#custom-type',
                GSI2SK: 'CHANNEL',
            });
        });

        it('should handle types with special characters', () => {
            const keys = ChannelRegistryKeyGenerator.createWellKnownKeys('type-with-dashes_and_underscores');

            expect(keys).toEqual({
                GSI2PK: 'WELLKNOWN#type-with-dashes_and_underscores',
                GSI2SK: 'CHANNEL',
            });
        });

        it('should handle empty type string', () => {
            const keys = ChannelRegistryKeyGenerator.createWellKnownKeys('');

            expect(keys).toEqual({
                GSI2PK: 'WELLKNOWN#',
                GSI2SK: 'CHANNEL',
            });
        });
    });

    describe('parseChannelId', () => {
        it('should parse valid PK correctly', () => {
            const channelId = ChannelRegistryKeyGenerator.parseChannelId('CHANNEL#123456');

            expect(channelId).toBe('123456');
        });

        it('should parse long channel ID correctly', () => {
            const channelId = ChannelRegistryKeyGenerator.parseChannelId('CHANNEL#1234567890123456789');

            expect(channelId).toBe('1234567890123456789');
        });

        it('should handle empty channel ID', () => {
            const channelId = ChannelRegistryKeyGenerator.parseChannelId('CHANNEL#');

            expect(channelId).toBe('');
        });

        it('should throw error for invalid PK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseChannelId('INVALID#123');
            }).toThrow('Invalid PK format: expected CHANNEL#..., got INVALID#123');
        });

        it('should throw error for missing prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseChannelId('123456');
            }).toThrow('Invalid PK format: expected CHANNEL#..., got 123456');
        });

        it('should throw error for lowercase prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseChannelId('channel#123456');
            }).toThrow('Invalid PK format: expected CHANNEL#..., got channel#123456');
        });

        it('should throw error for partial prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseChannelId('CHANN#123456');
            }).toThrow('Invalid PK format: expected CHANNEL#..., got CHANN#123456');
        });
    });

    describe('parseGuildKeys', () => {
        it('should parse valid GSI1 keys correctly', () => {
            const result = ChannelRegistryKeyGenerator.parseGuildKeys(
                'GUILD#789012',
                'CHANNEL#123456'
            );

            expect(result).toEqual({
                guildId:   '789012',
                channelId: '123456',
            });
        });

        it('should parse long IDs correctly', () => {
            const result = ChannelRegistryKeyGenerator.parseGuildKeys(
                'GUILD#9876543210987654321',
                'CHANNEL#1234567890123456789'
            );

            expect(result).toEqual({
                guildId:   '9876543210987654321',
                channelId: '1234567890123456789',
            });
        });

        it('should handle empty guild ID', () => {
            const result = ChannelRegistryKeyGenerator.parseGuildKeys(
                'GUILD#',
                'CHANNEL#test'
            );

            expect(result.guildId).toBe('');
        });

        it('should handle empty channel ID', () => {
            const result = ChannelRegistryKeyGenerator.parseGuildKeys(
                'GUILD#123',
                'CHANNEL#'
            );

            expect(result.channelId).toBe('');
        });

        it('should throw error for invalid GSI1PK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'INVALID#123',
                    'CHANNEL#test'
                );
            }).toThrow('Invalid GSI1PK format: expected GUILD#..., got INVALID#123');
        });

        it('should throw error for invalid GSI1SK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'GUILD#123',
                    'INVALID#test'
                );
            }).toThrow('Invalid GSI1SK format: expected CHANNEL#..., got INVALID#test');
        });

        it('should throw error for missing GSI1PK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    '123',
                    'CHANNEL#test'
                );
            }).toThrow('Invalid GSI1PK format: expected GUILD#..., got 123');
        });

        it('should throw error for missing GSI1SK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'GUILD#123',
                    'test'
                );
            }).toThrow('Invalid GSI1SK format: expected CHANNEL#..., got test');
        });

        it('should throw error for lowercase GSI1PK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'guild#123',
                    'CHANNEL#test'
                );
            }).toThrow('Invalid GSI1PK format: expected GUILD#..., got guild#123');
        });

        it('should throw error for lowercase GSI1SK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'GUILD#123',
                    'channel#test'
                );
            }).toThrow('Invalid GSI1SK format: expected CHANNEL#..., got channel#test');
        });

        it('should throw error for partial GSI1PK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'GUIL#123',
                    'CHANNEL#test'
                );
            }).toThrow('Invalid GSI1PK format: expected GUILD#..., got GUIL#123');
        });

        it('should throw error for partial GSI1SK prefix', () => {
            expect(() => {
                ChannelRegistryKeyGenerator.parseGuildKeys(
                    'GUILD#123',
                    'CHANN#test'
                );
            }).toThrow('Invalid GSI1SK format: expected CHANNEL#..., got CHANN#test');
        });
    });

    describe('round-trip consistency', () => {
        it('should maintain channelId through createKeys and parseChannelId', () => {
            const originalChannelId = '123456789';
            const keys = ChannelRegistryKeyGenerator.createKeys(originalChannelId, '999');
            const parsedChannelId = ChannelRegistryKeyGenerator.parseChannelId(keys.PK);

            expect(parsedChannelId).toBe(originalChannelId);
        });

        it('should maintain guildId and channelId through createKeys and parseGuildKeys', () => {
            const originalGuildId = '987654321';
            const originalChannelId = '111222333';
            const keys = ChannelRegistryKeyGenerator.createKeys(originalChannelId, originalGuildId);
            const { guildId, channelId } = ChannelRegistryKeyGenerator.parseGuildKeys(
                keys.GSI1PK,
                keys.GSI1SK
            );

            expect(guildId).toBe(originalGuildId);
            expect(channelId).toBe(originalChannelId);
        });
    });
});
