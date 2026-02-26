import { describe, test, expect } from 'bun:test';
import {
    guildIdSchema,
    channelIdSchema,
    userIdSchema,
    messageIdSchema,
    discordMessageContextSchema,
    createGuildId,
    createChannelId,
    createUserId,
    createMessageId,
    isGuildId,
    isChannelId,
    isUserId,
    isMessageId,
    type GuildId,
    type ChannelId,
    type UserId
} from '@/integrations/discord/types';

const idSchemas = [
    ['GuildId', guildIdSchema, '123456789012345678', 12_345, createGuildId, isGuildId],
    ['ChannelId', channelIdSchema, '987654321098765432', 98_765, createChannelId, isChannelId],
    ['UserId', userIdSchema, '111222333444555666', 11_122, createUserId, isUserId],
    ['MessageId', messageIdSchema, '1234567890123456789', 99_999, createMessageId, isMessageId],
] as const;

describe.concurrent('branded ID schemas', () => {
    test.each(idSchemas)('%s schema should accept valid ID', (_name, schema, validId) => {
        const result = schema.safeParse(validId);
        expect(result.success).toBe(true);
    });

    test.each(idSchemas)('%s schema should reject empty string', (_name, schema) => {
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

    test('should reject missing or invalid required fields', () => {
        // Missing guildId
        const { guildId: _guildId, ...noGuildId } = validContext;
        expect(discordMessageContextSchema.safeParse(noGuildId).success).toBe(false);

        // Invalid guildId (empty string)
        expect(discordMessageContextSchema.safeParse({ ...validContext, guildId: '' }).success).toBe(false);

        // Missing channelId
        const { channelId: _channelId, ...noChannelId } = validContext;
        expect(discordMessageContextSchema.safeParse(noChannelId).success).toBe(false);

        // Missing userId
        const { userId: _userId, ...noUserId } = validContext;
        expect(discordMessageContextSchema.safeParse(noUserId).success).toBe(false);

        // Missing messageId
        const { messageId: _messageId, ...noMessageId } = validContext;
        expect(discordMessageContextSchema.safeParse(noMessageId).success).toBe(false);

        // Empty messageId
        expect(discordMessageContextSchema.safeParse({ ...validContext, messageId: '' }).success).toBe(false);

        // Missing content
        const { content: _content, ...noContent } = validContext;
        expect(discordMessageContextSchema.safeParse(noContent).success).toBe(false);

        // Missing timestamp
        const { timestamp: _timestamp, ...noTimestamp } = validContext;
        expect(discordMessageContextSchema.safeParse(noTimestamp).success).toBe(false);

        // Invalid timestamp
        expect(discordMessageContextSchema.safeParse({ ...validContext, timestamp: 'not-a-date' }).success).toBe(false);
    });

    test('should accept field constraints: empty content and various ISO timestamps', () => {
        // Empty content is allowed
        expect(discordMessageContextSchema.safeParse({ ...validContext, content: '' }).success).toBe(true);

        // Various valid ISO timestamps
        const timestamps = [
            '2024-01-15T10:30:00.000Z',
            '2024-12-31T23:59:59.999Z',
            '2024-06-15T12:00:00.000Z',
        ];
        for(const timestamp of timestamps) {
            expect(discordMessageContextSchema.safeParse({ ...validContext, timestamp }).success).toBe(true);
        }
    });
});

describe('ID creator functions', () => {
    test.each(idSchemas)('create%s should create branded type from valid string', (_name, _schema, validId, _invalidNumber, creator) => {
        const result = creator(validId);
        // TypeScript ensures branded type is correct at compile time
        expect(result as string).toBe(validId);
    });

    test.each(idSchemas)('create%s should throw error for invalid input', (_name, _schema, _validId, invalidNumber, creator) => {
        // Empty string
        expect(() => creator('')).toThrow();

        // Non-string input
        // @ts-expect-error - testing runtime validation
        expect(() => creator(invalidNumber)).toThrow();
    });
});

describe('ID predicate functions', () => {
    test.each(idSchemas)('is%s should return true for valid ID', (_name, _schema, validId, _invalidNumber, creator, predicate) => {
        // Valid branded type
        const id = creator(validId);
        expect(predicate(id)).toBe(true);

        // Valid string
        expect(predicate(validId)).toBe(true);
    });

    test.each(idSchemas)('is%s should return false for invalid input', (_name, _schema, _validId, invalidNumber, _creator, predicate) => {
        // Empty string
        expect(predicate('')).toBe(false);

        // Non-string values
        expect(predicate(invalidNumber)).toBe(false);
        expect(predicate(null)).toBe(false);
        expect(predicate(undefined)).toBe(false);
        expect(predicate({})).toBe(false);
    });
});
