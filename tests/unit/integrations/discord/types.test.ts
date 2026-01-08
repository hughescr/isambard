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

const idSchemas = [
    ['GuildId', guildIdSchema, '123456789012345678', 12345, createGuildId, isGuildId],
    ['ChannelId', channelIdSchema, '987654321098765432', 98765, createChannelId, isChannelId],
    ['UserId', userIdSchema, '111222333444555666', 11122, createUserId, isUserId],
] as const;

describe.concurrent('branded ID schemas', () => {
    test.each(idSchemas)('%s schema should accept valid ID', (_name, schema, validId) => {
        const result = schema.safeParse(validId);
        expect(result.success).toBe(true);
    });

    test.each(idSchemas)('%s schema should reject empty string', (_name, schema) => {
        const result = schema.safeParse('');
        expect(result.success).toBe(false);
    });

    test.each(idSchemas)('%s schema should include descriptive error message for empty ID', (_name, schema) => {
        const result = schema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });

    test.each(idSchemas)('%s schema should reject non-string values', (_name, schema, _validId, invalidNumber) => {
        const result = schema.safeParse(invalidNumber);
        expect(result.success).toBe(false);
    });

    test.each(idSchemas)('%s schema should create branded type', (_name, schema, validId) => {
        const result = schema.safeParse(validId);
        expect(result.success).toBe(true);
        if(result.success) {
            // TypeScript ensures branded type is correct at compile time
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Parameterized test requires type assertion across different branded types
            expect(result.data).toBe(validId as any);
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

describe('ID creator functions', () => {
    test.each(idSchemas)('create%s should create branded type from valid string', (_name, _schema, validId, _invalidNumber, creator) => {
        const result = creator(validId);
        // TypeScript ensures branded type is correct at compile time
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Parameterized test requires type assertion across different branded types
        expect(result).toBe(validId as any);
    });

    test.each(idSchemas)('create%s should throw error for empty string', (_name, _schema, _validId, _invalidNumber, creator) => {
        expect(() => creator('')).toThrow();
    });

    test.each(idSchemas)('create%s should throw error for non-string input', (_name, _schema, _validId, invalidNumber, creator) => {
        // @ts-expect-error - testing runtime validation
        expect(() => creator(invalidNumber)).toThrow();
    });
});

describe('ID predicate functions', () => {
    test.each(idSchemas)('is%s should return true for valid branded type', (_name, _schema, validId, _invalidNumber, creator, predicate) => {
        const id = creator(validId);
        expect(predicate(id)).toBe(true);
    });

    test.each(idSchemas)('is%s should return true for valid string', (_name, _schema, validId, _invalidNumber, _creator, predicate) => {
        expect(predicate(validId)).toBe(true);
    });

    test.each(idSchemas)('is%s should return false for empty string', (_name, _schema, _validId, _invalidNumber, _creator, predicate) => {
        expect(predicate('')).toBe(false);
    });

    test.each(idSchemas)('is%s should return false for non-string values', (_name, _schema, _validId, invalidNumber, _creator, predicate) => {
        expect(predicate(invalidNumber)).toBe(false);
        expect(predicate(null)).toBe(false);
        expect(predicate(undefined)).toBe(false);
        expect(predicate({})).toBe(false);
    });
});
