import { describe, test, expect } from 'bun:test';
import {
    searchParamsSchema
} from '@/integrations/discord/message-history/types';
import type { ChannelId } from '@/integrations/discord/types';

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
