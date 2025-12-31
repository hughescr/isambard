import { describe, it, expect } from 'bun:test';
import {
    messageIdSchema,
    createMessageId,
    isMessageId,
    cachedMessageSchema,
    cachedSegmentSchema,
    type MessageId,
    type CacheGap
} from '@/storage/message-cache/types';
import type { ChannelId } from '@/integrations/discord/types';

describe('messageIdSchema', () => {
    it('should accept valid message ID', () => {
        const result = messageIdSchema.safeParse('123456789012345678');
        expect(result.success).toBe(true);
    });

    it('should reject empty string', () => {
        const result = messageIdSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    it('should include descriptive error message for empty MessageId', () => {
        const result = messageIdSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('cannot be empty');
        }
    });

    it('should reject non-string values', () => {
        const result = messageIdSchema.safeParse(12345);
        expect(result.success).toBe(false);
    });

    it('should create branded MessageId type', () => {
        const result = messageIdSchema.safeParse('123456789012345678');
        expect(result.success).toBe(true);
        if(result.success) {
            const messageId: MessageId = result.data;
            expect(messageId).toBe('123456789012345678' as MessageId);
        }
    });
});

describe('createMessageId', () => {
    it('should create MessageId from valid string', () => {
        const messageId = createMessageId('123456789012345678');
        expect(messageId).toBe('123456789012345678' as MessageId);
    });

    it('should throw error for empty string', () => {
        expect(() => createMessageId('')).toThrow();
    });

    it('should throw error for non-string input', () => {
        // @ts-expect-error - testing runtime validation
        expect(() => createMessageId(12345)).toThrow();
    });
});

describe('isMessageId', () => {
    it('should return true for valid MessageId', () => {
        const messageId = createMessageId('123456789012345678');
        expect(isMessageId(messageId)).toBe(true);
    });

    it('should return true for valid string', () => {
        expect(isMessageId('123456789012345678')).toBe(true);
    });

    it('should return false for empty string', () => {
        expect(isMessageId('')).toBe(false);
    });

    it('should return false for non-string values', () => {
        expect(isMessageId(12345)).toBe(false);
        expect(isMessageId(null)).toBe(false);
        expect(isMessageId(undefined)).toBe(false);
        expect(isMessageId({})).toBe(false);
    });
});

describe('cachedMessageSchema', () => {
    const validMessage = {
        id:        '123456789012345678' as MessageId,
        content:   'Hello, world!',
        authorId:  '987654321098765432',
        timestamp: '2024-01-15T10:30:00.000Z',
    };

    it('should validate complete cached message', () => {
        const result = cachedMessageSchema.safeParse(validMessage);
        expect(result.success).toBe(true);
    });

    it('should require id', () => {
        const { id: _id, ...noId } = validMessage;
        const result = cachedMessageSchema.safeParse(noId);
        expect(result.success).toBe(false);
    });

    it('should reject empty id', () => {
        const result = cachedMessageSchema.safeParse({ ...validMessage, id: '' });
        expect(result.success).toBe(false);
    });

    it('should require content', () => {
        const { content: _content, ...noContent } = validMessage;
        const result = cachedMessageSchema.safeParse(noContent);
        expect(result.success).toBe(false);
    });

    it('should accept empty content string', () => {
        const result = cachedMessageSchema.safeParse({ ...validMessage, content: '' });
        expect(result.success).toBe(true);
    });

    it('should require authorId', () => {
        const { authorId: _authorId, ...noAuthorId } = validMessage;
        const result = cachedMessageSchema.safeParse(noAuthorId);
        expect(result.success).toBe(false);
    });

    it('should reject empty authorId', () => {
        const result = cachedMessageSchema.safeParse({ ...validMessage, authorId: '' });
        expect(result.success).toBe(false);
    });

    it('should require timestamp', () => {
        const { timestamp: _timestamp, ...noTimestamp } = validMessage;
        const result = cachedMessageSchema.safeParse(noTimestamp);
        expect(result.success).toBe(false);
    });

    it('should validate timestamp as ISO datetime', () => {
        const result = cachedMessageSchema.safeParse({ ...validMessage, timestamp: 'not-a-date' });
        expect(result.success).toBe(false);
    });
});

describe('cachedSegmentSchema', () => {
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

    it('should validate complete cached segment', () => {
        const result = cachedSegmentSchema.safeParse(validSegment);
        expect(result.success).toBe(true);
    });

    it('should require channelId', () => {
        const { channelId: _channelId, ...noChannelId } = validSegment;
        const result = cachedSegmentSchema.safeParse(noChannelId);
        expect(result.success).toBe(false);
    });

    it('should require startSnowflake', () => {
        const { startSnowflake: _startSnowflake, ...noStartSnowflake } = validSegment;
        const result = cachedSegmentSchema.safeParse(noStartSnowflake);
        expect(result.success).toBe(false);
    });

    it('should require endSnowflake', () => {
        const { endSnowflake: _endSnowflake, ...noEndSnowflake } = validSegment;
        const result = cachedSegmentSchema.safeParse(noEndSnowflake);
        expect(result.success).toBe(false);
    });

    it('should require messages array', () => {
        const { messages: _messages, ...noMessages } = validSegment;
        const result = cachedSegmentSchema.safeParse(noMessages);
        expect(result.success).toBe(false);
    });

    it('should accept empty messages array', () => {
        const result = cachedSegmentSchema.safeParse({ ...validSegment, messages: [] });
        expect(result.success).toBe(true);
    });

    it('should validate messages in array', () => {
        const invalidMessages = [{ id: '', content: 'Bad', authorId: 'x', timestamp: 'invalid' }];
        const result = cachedSegmentSchema.safeParse({ ...validSegment, messages: invalidMessages });
        expect(result.success).toBe(false);
    });

    it('should require fetchedAt', () => {
        const { fetchedAt: _fetchedAt, ...noFetchedAt } = validSegment;
        const result = cachedSegmentSchema.safeParse(noFetchedAt);
        expect(result.success).toBe(false);
    });

    it('should validate fetchedAt as ISO datetime', () => {
        const result = cachedSegmentSchema.safeParse({ ...validSegment, fetchedAt: 'not-a-date' });
        expect(result.success).toBe(false);
    });
});

describe('CacheGap type', () => {
    it('should allow creating CacheGap objects', () => {
        const gap: CacheGap = {
            start: '100' as MessageId,
            end:   '199' as MessageId,
        };
        expect(gap.start).toBe('100' as MessageId);
        expect(gap.end).toBe('199' as MessageId);
    });
});
