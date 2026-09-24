import { describe, test, expect } from 'bun:test';
import {
    discordSearchResultSchema,
    searchResponseSchema,
    batchOverflowSummarySchema,
    type DiscordSearchResult,
    type SearchResponse,
    type BatchOverflowSummary
} from '@/integrations/discord/message-history/types';
import type { ChannelId, GuildId } from '@/integrations/discord/types';

const validSearchResult: DiscordSearchResult = {
    id:          '999888777666555444',
    channelId:   '123456789012345678' as ChannelId,
    guildId:     '987654321098765432' as GuildId,
    author:      { id: '111222333444555666', username: 'testuser', displayName: 'Test User' },
    content:     'Hello, world!',
    timestamp:   '2024-01-15T10:30:00.000Z',
    attachments: [],
    embeds:      [],
    reactions:   [],
};

const validBatch: BatchOverflowSummary = {
    startTimestamp: '2024-01-14T10:00:00.000Z',
    endTimestamp:   '2024-01-14T11:00:00.000Z',
    messageCount:   10,
    authors:        ['alice', 'bob'],
    synopsis:       'Discussion about deployment plans',
};

const completeMetadata = {
    coverage:         'complete' as const,
    fetched:          1,
    matchedInFetched: 1,
    timeRange:        { start: '2024-01-15T00:00:00.000Z', end: '2024-01-15T23:59:59.999Z' },
};

const validSearchResponse: SearchResponse = { messages: [validSearchResult], metadata: completeMetadata };

describe.concurrent('discordSearchResultSchema', () => {
    test('accepts required search result fields', () => {
        expect(discordSearchResultSchema.safeParse(validSearchResult).success).toBe(true);
    });

    test.each([
        ['id', { id: '' }],
        ['channelId', { channelId: '' }],
        ['timestamp', { timestamp: 'not-a-date' }],
        ['replyTo', { replyTo: '' }],
    ])('rejects invalid %s', (_fieldName, override) => {
        expect(discordSearchResultSchema.safeParse({ ...validSearchResult, ...override }).success).toBe(false);
    });

    test.each([
        ['id', { id: 'a' }],
        ['replyTo', { replyTo: 'a' }],
    ])('accepts single-character %s', (_fieldName, override) => {
        expect(discordSearchResultSchema.safeParse({ ...validSearchResult, ...override }).success).toBe(true);
    });
});

describe('batchOverflowSummarySchema', () => {
    test('accepts valid batch summary', () => {
        expect(batchOverflowSummarySchema.safeParse(validBatch).success).toBe(true);
    });

    test.each([
        ['messageCount zero', { messageCount: 0 }],
        ['empty synopsis', { synopsis: '' }],
        ['empty author', { authors: [''] }],
    ])('rejects %s', (_name, override) => {
        expect(batchOverflowSummarySchema.safeParse({ ...validBatch, ...override }).success).toBe(false);
    });

    test.each([
        ['single-character synopsis', { synopsis: 'a' }],
        ['single-character author', { authors: ['a'] }],
    ])('accepts %s', (_name, override) => {
        expect(batchOverflowSummarySchema.safeParse({ ...validBatch, ...override }).success).toBe(true);
    });
});

describe('searchResponseSchema', () => {
    test('accepts a complete response without overflow', () => {
        expect(searchResponseSchema.safeParse(validSearchResponse).success).toBe(true);
    });

    test('accepts count-only overflow with older hint', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'count-only', count: 50, hint: 'Older messages were loaded but not returned' },
        });
        expect(result.success).toBe(true);
    });

    test('accepts summarized overflow with its covered count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'summarized', count: 101, batchSummaries: [validBatch], summarizedCount: 100, hint: 'Newer messages were not summarized' },
        });
        expect(result.success).toBe(true);
    });

    test('rejects summarized overflow when covered count exceeds overflow count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'summarized', count: 5, batchSummaries: [], summarizedCount: 10 },
        });
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('Summarized count cannot exceed overflow count');
            expect(result.error.issues[0]?.path).toEqual(['overflow', 'summarizedCount']);
        }
    });

    test('accepts count-only overflow with zero count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'count-only', count: 0 },
        });
        expect(result.success).toBe(true);
    });

    test('accepts summarized overflow with zero count and zero covered count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'summarized', count: 0, batchSummaries: [], summarizedCount: 0 },
        });
        expect(result.success).toBe(true);
    });

    test('accepts summarized overflow whose covered count equals the overflow count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'summarized', count: 5, batchSummaries: [], summarizedCount: 5 },
        });
        expect(result.success).toBe(true);
    });

    test('reports the exact message for a negative count-only overflow count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'count-only', count: -1 },
        });
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('Count cannot be negative');
        }
    });

    test('reports the exact message for a negative summarized overflow covered count', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'summarized', count: 1, batchSummaries: [], summarizedCount: -1 },
        });
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('Summarized count cannot be negative');
        }
    });

    test('rejects mixed count-only and summarized overflow fields', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: { mode: 'count-only', count: 1, batchSummaries: [validBatch], summarizedCount: 1 },
        });
        expect(result.success).toBe(false);
    });

    test.each([
        ['coverage', { ...completeMetadata, coverage: undefined }],
        ['fetched negative', { ...completeMetadata, fetched: -1 }],
        ['matchedInFetched negative', { ...completeMetadata, matchedInFetched: -1 }],
        ['time range', { coverage: 'complete', fetched: 1, matchedInFetched: 1 }],
    ])('rejects metadata missing or invalid %s', (_name, metadata) => {
        expect(searchResponseSchema.safeParse({ ...validSearchResponse, metadata }).success).toBe(false);
    });

    test.each([
        ['count-only negative count', { mode: 'count-only', count: -1 }],
        ['summarized negative count', { mode: 'summarized', count: -1, batchSummaries: [], summarizedCount: 0 }],
        ['summarized negative covered count', { mode: 'summarized', count: 1, batchSummaries: [], summarizedCount: -1 }],
    ])('rejects %s', (_name, overflow) => {
        expect(searchResponseSchema.safeParse({ ...validSearchResponse, overflow }).success).toBe(false);
    });

    test('accepts metadata with zero fetched and zero matchedInFetched', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: { ...completeMetadata, fetched: 0, matchedInFetched: 0 },
        });
        expect(result.success).toBe(true);
    });

    test('accepts limit-reached coverage', () => {
        expect(searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: { ...completeMetadata, coverage: 'limitReached' },
        }).success).toBe(true);
    });
});
