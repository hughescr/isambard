import { describe, it, expect } from 'bun:test';
import {
    searchParamsSchema,
    cachedMessageSegmentSchema,
    type CachedMessageSegment
} from '@/integrations/discord/message-history/types';
import type { ChannelId, GuildId } from '@/integrations/discord/types';

describe('searchParamsSchema', () => {
    // Using z.input type since SearchParams includes defaults that aren't in input
    const validParams = {
        channelId: '123456789012345678' as ChannelId,
    };

    it('should accept minimal valid params with only channelId', () => {
        const result = searchParamsSchema.safeParse(validParams);
        expect(result.success).toBe(true);
    });

    it('should accept params with query', () => {
        const result = searchParamsSchema.safeParse({
            ...validParams,
            query: 'search term',
        });
        expect(result.success).toBe(true);
    });

    it('should accept params with startTime', () => {
        const startTime = new Date('2024-01-15T00:00:00.000Z');
        const result = searchParamsSchema.safeParse({
            ...validParams,
            startTime,
        });
        expect(result.success).toBe(true);
    });

    it('should accept params with endTime', () => {
        const endTime = new Date('2024-01-15T23:59:59.999Z');
        const result = searchParamsSchema.safeParse({
            ...validParams,
            endTime,
        });
        expect(result.success).toBe(true);
    });

    it('should accept params with limit', () => {
        const result = searchParamsSchema.safeParse({
            ...validParams,
            limit: 50,
        });
        expect(result.success).toBe(true);
    });

    it('should accept params with all optional fields', () => {
        const result = searchParamsSchema.safeParse({
            channelId: '123456789012345678' as ChannelId,
            query:     'search term',
            startTime: new Date('2024-01-15T00:00:00.000Z'),
            endTime:   new Date('2024-01-15T23:59:59.999Z'),
            limit:     25,
        });
        expect(result.success).toBe(true);
    });

    it('should require channelId', () => {
        const result = searchParamsSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('should reject empty channelId', () => {
        const result = searchParamsSchema.safeParse({ channelId: '' });
        expect(result.success).toBe(false);
    });

    it('should apply default limit of 10', () => {
        const result = searchParamsSchema.safeParse(validParams);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.limit).toBe(10);
        }
    });

    it('should accept limit of 1', () => {
        const result = searchParamsSchema.safeParse({ ...validParams, limit: 1 });
        expect(result.success).toBe(true);
    });

    it('should reject limit of 0', () => {
        const result = searchParamsSchema.safeParse({ ...validParams, limit: 0 });
        expect(result.success).toBe(false);
    });

    it('should reject negative limit', () => {
        const result = searchParamsSchema.safeParse({ ...validParams, limit: -10 });
        expect(result.success).toBe(false);
    });

    it('should reject non-integer limit', () => {
        const result = searchParamsSchema.safeParse({ ...validParams, limit: 10.5 });
        expect(result.success).toBe(false);
    });

    it('should accept limit of 100', () => {
        const result = searchParamsSchema.safeParse({ ...validParams, limit: 100 });
        expect(result.success).toBe(true);
    });

    it('should reject limit over 100', () => {
        const result = searchParamsSchema.safeParse({ ...validParams, limit: 101 });
        expect(result.success).toBe(false);
    });
});

describe('cachedMessageSegmentSchema', () => {
    const validCache: CachedMessageSegment = {
        channelId:      '123456789012345678' as ChannelId,
        startSnowflake: '999000000000000000',
        endSnowflake:   '999999999999999999',
        messages:       [
            {
                id:        '999888777666555444',
                channelId: '123456789012345678' as ChannelId,
                guildId:   '987654321098765432' as GuildId,
                author:    {
                    id:          '111222333444555666',
                    username:    'testuser',
                    displayName: 'Test User',
                },
                content:     'Cached message',
                timestamp:   '2024-01-15T10:30:00.000Z',
                attachments: [],
                embeds:      [],
                reactions:   [],
            },
        ],
        createdAt: '2024-01-15T12:00:00.000Z',
        ttl:       1705320000, // Unix timestamp
    };

    it('should accept valid cached message segment', () => {
        const result = cachedMessageSegmentSchema.safeParse(validCache);
        expect(result.success).toBe(true);
    });

    it('should accept empty messages array', () => {
        const result = cachedMessageSegmentSchema.safeParse({
            ...validCache,
            messages: [],
        });
        expect(result.success).toBe(true);
    });

    it('should require channelId', () => {
        const { channelId: _channelId, ...noChannelId } = validCache;
        const result = cachedMessageSegmentSchema.safeParse(noChannelId);
        expect(result.success).toBe(false);
    });

    it('should reject empty channelId', () => {
        const result = cachedMessageSegmentSchema.safeParse({ ...validCache, channelId: '' });
        expect(result.success).toBe(false);
    });

    it('should require startSnowflake', () => {
        const { startSnowflake: _startSnowflake, ...noStart } = validCache;
        const result = cachedMessageSegmentSchema.safeParse(noStart);
        expect(result.success).toBe(false);
    });

    it('should validate startSnowflake format', () => {
        const result = cachedMessageSegmentSchema.safeParse({
            ...validCache,
            startSnowflake: 'not-a-snowflake',
        });
        expect(result.success).toBe(false);
    });

    it('should require endSnowflake', () => {
        const { endSnowflake: _endSnowflake, ...noEnd } = validCache;
        const result = cachedMessageSegmentSchema.safeParse(noEnd);
        expect(result.success).toBe(false);
    });

    it('should validate endSnowflake format', () => {
        const result = cachedMessageSegmentSchema.safeParse({
            ...validCache,
            endSnowflake: 'invalid',
        });
        expect(result.success).toBe(false);
    });

    it('should require messages', () => {
        const { messages: _messages, ...noMessages } = validCache;
        const result = cachedMessageSegmentSchema.safeParse(noMessages);
        expect(result.success).toBe(false);
    });

    it('should require createdAt', () => {
        const { createdAt: _createdAt, ...noCreatedAt } = validCache;
        const result = cachedMessageSegmentSchema.safeParse(noCreatedAt);
        expect(result.success).toBe(false);
    });

    it('should validate createdAt as ISO datetime', () => {
        const result = cachedMessageSegmentSchema.safeParse({
            ...validCache,
            createdAt: 'not-a-date',
        });
        expect(result.success).toBe(false);
    });

    it('should require ttl', () => {
        const { ttl: _ttl, ...noTtl } = validCache;
        const result = cachedMessageSegmentSchema.safeParse(noTtl);
        expect(result.success).toBe(false);
    });

    it('should require ttl to be positive integer', () => {
        const result = cachedMessageSegmentSchema.safeParse({ ...validCache, ttl: 0 });
        expect(result.success).toBe(false);
    });

    it('should reject negative ttl', () => {
        const result = cachedMessageSegmentSchema.safeParse({ ...validCache, ttl: -1 });
        expect(result.success).toBe(false);
    });

    it('should reject non-integer ttl', () => {
        const result = cachedMessageSegmentSchema.safeParse({ ...validCache, ttl: 1705320000.5 });
        expect(result.success).toBe(false);
    });
});
