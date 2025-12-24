import { describe, it, expect } from 'bun:test';
import { discordConfigSchema } from '@/config/schemas';

describe('discordConfigSchema - monitoredChannelIds', () => {
    it('should validate Discord config with empty monitoredChannelIds', () => {
        const validConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: [],
        };

        const result = discordConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.monitoredChannelIds).toEqual([]);
        }
    });

    it('should validate Discord config with single monitoredChannelId', () => {
        const validConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['987654321098765432'],
        };

        const result = discordConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.monitoredChannelIds).toEqual(['987654321098765432']);
        }
    });

    it('should validate Discord config with multiple monitoredChannelIds', () => {
        const validConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['111111111111111111', '222222222222222222', '333333333333333333'],
        };

        const result = discordConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.monitoredChannelIds).toEqual([
                '111111111111111111',
                '222222222222222222',
                '333333333333333333',
            ]);
        }
    });

    it('should apply default empty array when monitoredChannelIds not provided', () => {
        const configWithoutChannelIds = {
            botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId: '123456789012345678',
        };

        const result = discordConfigSchema.safeParse(configWithoutChannelIds);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.monitoredChannelIds).toEqual([]);
        }
    });

    it('should reject empty string in monitoredChannelIds array', () => {
        const invalidConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['111111111111111111', '', '222222222222222222'],
        };

        const result = discordConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    it('should reject non-string values in monitoredChannelIds array', () => {
        const invalidConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: ['111111111111111111', 12345, '222222222222222222'],
        };

        const result = discordConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    it('should reject non-array monitoredChannelIds', () => {
        const invalidConfig = {
            botToken:            'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
            applicationId:       '123456789012345678',
            monitoredChannelIds: '111111111111111111',
        };

        const result = discordConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });
});
