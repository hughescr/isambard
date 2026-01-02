import { describe, test, expect } from 'bun:test';
import {
    guildIdSchema,
    channelIdSchema,
    userIdSchema,
    discordMessageContextSchema,
    createGuildId,
    createChannelId,
    createUserId,
    isGuildId,
    isChannelId,
    isUserId,
    type GuildId,
    type ChannelId,
    type UserId
} from '@/integrations/discord/types';

describe.concurrent('guildIdSchema', () => {
    test('should accept valid guild ID', () => {
        const result = guildIdSchema.safeParse('123456789012345678');
        expect(result.success).toBe(true);
    });

    test('should reject empty string', () => {
        const result = guildIdSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    test('should include descriptive error message for empty GuildId', () => {
        const result = guildIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });

    test('should reject non-string values', () => {
        const result = guildIdSchema.safeParse(12345);
        expect(result.success).toBe(false);
    });

    test('should create branded GuildId type', () => {
        const result = guildIdSchema.safeParse('123456789012345678');
        expect(result.success).toBe(true);
        if(result.success) {
            const guildId: GuildId = result.data;
            expect(guildId).toBe('123456789012345678' as GuildId);
        }
    });
});

describe('channelIdSchema', () => {
    test('should accept valid channel ID', () => {
        const result = channelIdSchema.safeParse('987654321098765432');
        expect(result.success).toBe(true);
    });

    test('should reject empty string', () => {
        const result = channelIdSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    test('should include descriptive error message for empty ChannelId', () => {
        const result = channelIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });

    test('should reject non-string values', () => {
        const result = channelIdSchema.safeParse(98765);
        expect(result.success).toBe(false);
    });

    test('should create branded ChannelId type', () => {
        const result = channelIdSchema.safeParse('987654321098765432');
        expect(result.success).toBe(true);
        if(result.success) {
            const channelId: ChannelId = result.data;
            expect(channelId).toBe('987654321098765432' as ChannelId);
        }
    });
});

describe('userIdSchema', () => {
    test('should accept valid user ID', () => {
        const result = userIdSchema.safeParse('111222333444555666');
        expect(result.success).toBe(true);
    });

    test('should reject empty string', () => {
        const result = userIdSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    test('should include descriptive error message for empty UserId', () => {
        const result = userIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });

    test('should reject non-string values', () => {
        const result = userIdSchema.safeParse(11122);
        expect(result.success).toBe(false);
    });

    test('should create branded UserId type', () => {
        const result = userIdSchema.safeParse('111222333444555666');
        expect(result.success).toBe(true);
        if(result.success) {
            const userId: UserId = result.data;
            expect(userId).toBe('111222333444555666' as UserId);
        }
    });
});

describe('discordMessageContextSchema', () => {
    const validContext = {
        guildId:   '123456789012345678' as GuildId,
        channelId: '987654321098765432' as ChannelId,
        userId:    '111222333444555666' as UserId,
        botUserId: '999999999999999999' as UserId,
        messageId: '999888777666555444',
        content:   'Hello, world!',
        timestamp: '2024-01-15T10:30:00.000Z',
    };

    test('should validate complete Discord message context', () => {
        const result = discordMessageContextSchema.safeParse(validContext);
        expect(result.success).toBe(true);
    });

    test('should require guildId', () => {
        const { guildId: _guildId, ...noGuildId } = validContext;
        const result = discordMessageContextSchema.safeParse(noGuildId);
        expect(result.success).toBe(false);
    });

    test('should require valid GuildId type for guildId', () => {
        const result = discordMessageContextSchema.safeParse({ ...validContext, guildId: '' });
        expect(result.success).toBe(false);
    });

    test('should require channelId', () => {
        const { channelId: _channelId, ...noChannelId } = validContext;
        const result = discordMessageContextSchema.safeParse(noChannelId);
        expect(result.success).toBe(false);
    });

    test('should require valid ChannelId type for channelId', () => {
        const result = discordMessageContextSchema.safeParse({ ...validContext, channelId: '' });
        expect(result.success).toBe(false);
    });

    test('should require userId', () => {
        const { userId: _userId, ...noUserId } = validContext;
        const result = discordMessageContextSchema.safeParse(noUserId);
        expect(result.success).toBe(false);
    });

    test('should require valid UserId type for userId', () => {
        const result = discordMessageContextSchema.safeParse({ ...validContext, userId: '' });
        expect(result.success).toBe(false);
    });

    test('should require messageId', () => {
        const { messageId: _messageId, ...noMessageId } = validContext;
        const result = discordMessageContextSchema.safeParse(noMessageId);
        expect(result.success).toBe(false);
    });

    test('should reject empty messageId', () => {
        const result = discordMessageContextSchema.safeParse({ ...validContext, messageId: '' });
        expect(result.success).toBe(false);
    });

    test('should require content', () => {
        const { content: _content, ...noContent } = validContext;
        const result = discordMessageContextSchema.safeParse(noContent);
        expect(result.success).toBe(false);
    });

    test('should accept empty content string', () => {
        const result = discordMessageContextSchema.safeParse({ ...validContext, content: '' });
        expect(result.success).toBe(true);
    });

    test('should require timestamp', () => {
        const { timestamp: _timestamp, ...noTimestamp } = validContext;
        const result = discordMessageContextSchema.safeParse(noTimestamp);
        expect(result.success).toBe(false);
    });

    test('should validate timestamp as ISO datetime', () => {
        const result = discordMessageContextSchema.safeParse({ ...validContext, timestamp: 'not-a-date' });
        expect(result.success).toBe(false);
    });

    test('should accept valid ISO datetime formats', () => {
        const timestamps = [
            '2024-01-15T10:30:00.000Z',
            '2024-12-31T23:59:59.999Z',
            '2024-06-15T12:00:00.000Z',
        ];

        for(const timestamp of timestamps) {
            const result = discordMessageContextSchema.safeParse({ ...validContext, timestamp });
            expect(result.success).toBe(true);
        }
    });
});

describe('createGuildId', () => {
    test('should create GuildId from valid string', () => {
        const guildId = createGuildId('123456789012345678');
        expect(guildId).toBe('123456789012345678' as GuildId);
    });

    test('should throw error for empty string', () => {
        expect(() => createGuildId('')).toThrow();
    });

    test('should throw error for non-string input', () => {
        // @ts-expect-error - testing runtime validation
        expect(() => createGuildId(12345)).toThrow();
    });
});

describe('createChannelId', () => {
    test('should create ChannelId from valid string', () => {
        const channelId = createChannelId('987654321098765432');
        expect(channelId).toBe('987654321098765432' as ChannelId);
    });

    test('should throw error for empty string', () => {
        expect(() => createChannelId('')).toThrow();
    });

    test('should throw error for non-string input', () => {
        // @ts-expect-error - testing runtime validation
        expect(() => createChannelId(98765)).toThrow();
    });
});

describe('createUserId', () => {
    test('should create UserId from valid string', () => {
        const userId = createUserId('111222333444555666');
        expect(userId).toBe('111222333444555666' as UserId);
    });

    test('should throw error for empty string', () => {
        expect(() => createUserId('')).toThrow();
    });

    test('should throw error for non-string input', () => {
        // @ts-expect-error - testing runtime validation
        expect(() => createUserId(11122)).toThrow();
    });
});

describe('isGuildId', () => {
    test('should return true for valid GuildId', () => {
        const guildId = createGuildId('123456789012345678');
        expect(isGuildId(guildId)).toBe(true);
    });

    test('should return true for valid string', () => {
        expect(isGuildId('123456789012345678')).toBe(true);
    });

    test('should return false for empty string', () => {
        expect(isGuildId('')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isGuildId(12345)).toBe(false);
        expect(isGuildId(null)).toBe(false);
        expect(isGuildId(undefined)).toBe(false);
        expect(isGuildId({})).toBe(false);
    });
});

describe('isChannelId', () => {
    test('should return true for valid ChannelId', () => {
        const channelId = createChannelId('987654321098765432');
        expect(isChannelId(channelId)).toBe(true);
    });

    test('should return true for valid string', () => {
        expect(isChannelId('987654321098765432')).toBe(true);
    });

    test('should return false for empty string', () => {
        expect(isChannelId('')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isChannelId(98765)).toBe(false);
        expect(isChannelId(null)).toBe(false);
        expect(isChannelId(undefined)).toBe(false);
        expect(isChannelId({})).toBe(false);
    });
});

describe('isUserId', () => {
    test('should return true for valid UserId', () => {
        const userId = createUserId('111222333444555666');
        expect(isUserId(userId)).toBe(true);
    });

    test('should return true for valid string', () => {
        expect(isUserId('111222333444555666')).toBe(true);
    });

    test('should return false for empty string', () => {
        expect(isUserId('')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isUserId(11122)).toBe(false);
        expect(isUserId(null)).toBe(false);
        expect(isUserId(undefined)).toBe(false);
        expect(isUserId({})).toBe(false);
    });
});
