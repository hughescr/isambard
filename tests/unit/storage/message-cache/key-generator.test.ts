import { describe, it, expect } from 'bun:test';
import { MessageCacheKeyGenerator } from '@/storage/message-cache/key-generator';
import type { ChannelId } from '@/integrations/discord/types';
import type { MessageId } from '@/storage/message-cache/types';

describe('MessageCacheKeyGenerator', () => {
    describe('createKeys', () => {
        it('should create correct PK and SK for segment', () => {
            const keys = MessageCacheKeyGenerator.createKeys(
                '123456789' as ChannelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(keys.PK).toBe('CHANNEL#123456789');
            expect(keys.SK).toBe('SEGMENT#100#200');
        });

        it('should handle large snowflake IDs', () => {
            const keys = MessageCacheKeyGenerator.createKeys(
                '987654321098765432' as ChannelId,
                '1234567890123456789' as MessageId,
                '9876543210987654321' as MessageId
            );

            expect(keys.PK).toBe('CHANNEL#987654321098765432');
            expect(keys.SK).toBe('SEGMENT#1234567890123456789#9876543210987654321');
        });
    });

    describe('parseKeys', () => {
        it('should parse PK back to channelId', () => {
            const { channelId } = MessageCacheKeyGenerator.parseKeys(
                'CHANNEL#123456789',
                'SEGMENT#100#200'
            );

            expect(channelId).toBe('123456789');
        });

        it('should parse SK back to startSnowflake and endSnowflake', () => {
            const { startSnowflake, endSnowflake } = MessageCacheKeyGenerator.parseKeys(
                'CHANNEL#123456789',
                'SEGMENT#100#200'
            );

            expect(startSnowflake).toBe('100');
            expect(endSnowflake).toBe('200');
        });

        it('should throw error for invalid PK format', () => {
            expect(() => MessageCacheKeyGenerator.parseKeys(
                'INVALID#123456789',
                'SEGMENT#100#200'
            )).toThrow('Invalid PK format: expected CHANNEL#...');
        });

        it('should throw error for invalid SK format', () => {
            expect(() => MessageCacheKeyGenerator.parseKeys(
                'CHANNEL#123456789',
                'INVALID#100#200'
            )).toThrow('Invalid SK format: expected SEGMENT#');
        });

        it('should throw error for malformed SK without two snowflakes', () => {
            expect(() => MessageCacheKeyGenerator.parseKeys(
                'CHANNEL#123456789',
                'SEGMENT#100'
            )).toThrow('Invalid SK format: expected SEGMENT#');
        });
    });

    describe('createChannelQueryKey', () => {
        it('should create correct PK for channel query', () => {
            const pk = MessageCacheKeyGenerator.createChannelQueryKey('123456789' as ChannelId);
            expect(pk).toBe('CHANNEL#123456789');
        });
    });

    describe('roundtrip', () => {
        it('should roundtrip keys correctly', () => {
            const originalChannelId = '987654321098765432';
            const originalStart = '1234567890123456789';
            const originalEnd = '9876543210987654321';

            const keys = MessageCacheKeyGenerator.createKeys(
                originalChannelId as ChannelId,
                originalStart as MessageId,
                originalEnd as MessageId
            );

            const parsed = MessageCacheKeyGenerator.parseKeys(keys.PK, keys.SK);

            expect(parsed.channelId).toBe(originalChannelId);
            expect(parsed.startSnowflake).toBe(originalStart);
            expect(parsed.endSnowflake).toBe(originalEnd);
        });
    });
});
