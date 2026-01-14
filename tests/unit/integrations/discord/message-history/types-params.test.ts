import { describe, test, expect } from 'bun:test';
import {
    searchParamsSchema,
    cachedMessageSegmentSchema,
    type CachedMessageSegment
} from '@/integrations/discord/message-history/types';
import type { ChannelId, GuildId } from '@/integrations/discord/types';

describe.concurrent('searchParamsSchema', () => {
    const validParams = {
        channelId: '123456789012345678' as ChannelId,
    };

    test('should accept valid params and apply default limit of 10', () => {
        const result = searchParamsSchema.safeParse(validParams);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.limit).toBe(10);
        }
    });

    test('should accept params with all optional fields', () => {
        const result = searchParamsSchema.safeParse({
            channelId: '123456789012345678' as ChannelId,
            query:     'search term',
            startTime: new Date('2024-01-15T00:00:00.000Z'),
            endTime:   new Date('2024-01-15T23:59:59.999Z'),
            limit:     25,
        });
        expect(result.success).toBe(true);
    });

    test.each([
        ['missing channelId', {}, false],
        ['empty channelId', { channelId: '' }, false],
    ])('channelId validation: %s', (_desc, params, expected) => {
        expect(searchParamsSchema.safeParse(params).success).toBe(expected);
    });

    test.each([
        ['minimum valid (1)', 1, true],
        ['maximum valid (100)', 100, true],
        ['zero', 0, false],
        ['negative', -10, false],
        ['non-integer', 10.5, false],
        ['over maximum (101)', 101, false],
    ])('limit validation: %s', (_desc, limit, expected) => {
        expect(searchParamsSchema.safeParse({ ...validParams, limit }).success).toBe(expected);
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

    test('should accept valid cached segment with messages', () => {
        expect(cachedMessageSegmentSchema.safeParse(validCache).success).toBe(true);
    });

    test('should accept empty messages array', () => {
        expect(cachedMessageSegmentSchema.safeParse({ ...validCache, messages: [] }).success).toBe(true);
    });

    test.each([
        ['channelId missing', (c: CachedMessageSegment) => {
            const { channelId: _, ...rest } = c;
            return rest;
        }],
        ['channelId empty', (c: CachedMessageSegment) => ({ ...c, channelId: '' })],
        ['startSnowflake missing', (c: CachedMessageSegment) => {
            const { startSnowflake: _, ...rest } = c;
            return rest;
        }],
        ['startSnowflake invalid format', (c: CachedMessageSegment) => ({ ...c, startSnowflake: 'not-a-snowflake' })],
        ['endSnowflake missing', (c: CachedMessageSegment) => {
            const { endSnowflake: _, ...rest } = c;
            return rest;
        }],
        ['endSnowflake invalid format', (c: CachedMessageSegment) => ({ ...c, endSnowflake: 'invalid' })],
        ['messages missing', (c: CachedMessageSegment) => {
            const { messages: _, ...rest } = c;
            return rest;
        }],
        ['createdAt missing', (c: CachedMessageSegment) => {
            const { createdAt: _, ...rest } = c;
            return rest;
        }],
        ['createdAt invalid format', (c: CachedMessageSegment) => ({ ...c, createdAt: 'not-a-date' })],
        ['ttl missing', (c: CachedMessageSegment) => {
            const { ttl: _, ...rest } = c;
            return rest;
        }],
        ['ttl zero', (c: CachedMessageSegment) => ({ ...c, ttl: 0 })],
        ['ttl negative', (c: CachedMessageSegment) => ({ ...c, ttl: -1 })],
        ['ttl non-integer', (c: CachedMessageSegment) => ({ ...c, ttl: 1705320000.5 })],
    ])('should reject invalid data: %s', (_desc, mutate) => {
        expect(cachedMessageSegmentSchema.safeParse(mutate(validCache)).success).toBe(false);
    });
});
