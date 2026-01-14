import { describe, test, expect } from 'bun:test';
import {
    messageIdSchema,
    createMessageId,
    isMessageId,
    cachedMessageSchema,
    cachedSegmentSchema,
    type MessageId
} from '@/storage/message-cache/types';
import type { ChannelId } from '@/integrations/discord/types';

describe.concurrent('messageIdSchema', () => {
    test.each([
        ['valid string', '123456789012345678', true],
        ['empty string', '', false],
        ['non-string', 12345, false],
    ])('should validate %s', (_desc, input, expected) => {
        const result = messageIdSchema.safeParse(input);
        expect(result.success).toBe(expected);
    });

    test('should include descriptive error message for empty MessageId', () => {
        const result = messageIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });
});

describe.concurrent('createMessageId', () => {
    test('should create MessageId from valid string', () => {
        const messageId = createMessageId('123456789012345678');
        expect(messageId).toBe('123456789012345678' as MessageId);
    });

    test.each([
        ['empty string', ''],
        ['non-string', 12345],
    ] as const)('should throw for %s', (_desc, input) => {
        // @ts-expect-error - testing runtime validation
        expect(() => createMessageId(input)).toThrow();
    });
});

describe.concurrent('isMessageId', () => {
    test.each([
        ['valid string', '123456789012345678', true],
        ['empty string', '', false],
        ['number', 12345, false],
        ['null', null, false],
        ['undefined', undefined, false],
        ['object', {}, false],
    ])('should return %s for %s', (_desc, input, expected) => {
        expect(isMessageId(input)).toBe(expected);
    });
});

describe.concurrent('cachedMessageSchema', () => {
    const validMessage = {
        id:        '123456789012345678' as MessageId,
        content:   'Hello, world!',
        authorId:  '987654321098765432',
        timestamp: '2024-01-15T10:30:00.000Z',
    };

    test('should validate complete cached message', () => {
        const result = cachedMessageSchema.safeParse(validMessage);
        expect(result.success).toBe(true);
    });

    test.each([
        ['missing id', { content: 'test', authorId: '123', timestamp: '2024-01-15T10:30:00.000Z' }, false],
        ['empty id', { ...validMessage, id: '' }, false],
        ['missing content', { id: '123' as MessageId, authorId: '123', timestamp: '2024-01-15T10:30:00.000Z' }, false],
        ['empty content', { ...validMessage, content: '' }, true],
        ['missing authorId', { id: '123' as MessageId, content: 'test', timestamp: '2024-01-15T10:30:00.000Z' }, false],
        ['empty authorId', { ...validMessage, authorId: '' }, false],
        ['missing timestamp', { id: '123' as MessageId, content: 'test', authorId: '123' }, false],
        ['invalid timestamp', { ...validMessage, timestamp: 'not-a-date' }, false],
    ])('should validate %s', (_desc, input, expected) => {
        const result = cachedMessageSchema.safeParse(input);
        expect(result.success).toBe(expected);
    });
});

describe.concurrent('cachedSegmentSchema', () => {
    const validSegment = {
        channelId:      '987654321098765432' as ChannelId,
        startSnowflake: '100' as MessageId,
        endSnowflake:   '200' as MessageId,
        messages:       [
            {
                id:        '150' as MessageId,
                content:   'Test message',
                authorId:  '111222333444555666',
                timestamp: '2024-01-15T10:30:00.000Z',
            },
        ],
        fetchedAt: '2024-01-15T11:00:00.000Z',
    };

    test('should validate complete cached segment', () => {
        const result = cachedSegmentSchema.safeParse(validSegment);
        expect(result.success).toBe(true);
    });

    test.each([
        ['missing channelId', { startSnowflake: '100' as MessageId, endSnowflake: '200' as MessageId, messages: [], fetchedAt: '2024-01-15T11:00:00.000Z' }, false],
        ['missing startSnowflake', { channelId: '123' as ChannelId, endSnowflake: '200' as MessageId, messages: [], fetchedAt: '2024-01-15T11:00:00.000Z' }, false],
        ['missing endSnowflake', { channelId: '123' as ChannelId, startSnowflake: '100' as MessageId, messages: [], fetchedAt: '2024-01-15T11:00:00.000Z' }, false],
        ['missing messages', { channelId: '123' as ChannelId, startSnowflake: '100' as MessageId, endSnowflake: '200' as MessageId, fetchedAt: '2024-01-15T11:00:00.000Z' }, false],
        ['empty messages', { ...validSegment, messages: [] }, true],
        ['invalid message', { ...validSegment, messages: [{ id: '', content: 'Bad', authorId: 'x', timestamp: 'invalid' }] }, false],
        ['missing fetchedAt', { channelId: '123' as ChannelId, startSnowflake: '100' as MessageId, endSnowflake: '200' as MessageId, messages: [] }, false],
        ['invalid fetchedAt', { ...validSegment, fetchedAt: 'not-a-date' }, false],
    ])('should validate %s', (_desc, input, expected) => {
        const result = cachedSegmentSchema.safeParse(input);
        expect(result.success).toBe(expected);
    });
});
