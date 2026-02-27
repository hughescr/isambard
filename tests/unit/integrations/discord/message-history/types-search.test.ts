import { describe, test, expect } from 'bun:test';
import {
    discordSearchResultSchema,
    overflowSummarySchema,
    searchResponseSchema,
    batchOverflowSummarySchema,
    type DiscordSearchResult,
    type OverflowSummary,
    type SearchResponse,
    type BatchOverflowSummary
} from '@/integrations/discord/message-history/types';
import type { ChannelId, GuildId } from '@/integrations/discord/types';

describe.concurrent('discordSearchResultSchema', () => {
    const validSearchResult: DiscordSearchResult = {
        id:        '999888777666555444',
        channelId: '123456789012345678' as ChannelId,
        guildId:   '987654321098765432' as GuildId,
        author:    {
            id:          '111222333444555666',
            username:    'testuser',
            displayName: 'Test User',
        },
        content:     'Hello, world!',
        timestamp:   '2024-01-15T10:30:00.000Z',
        attachments: [],
        embeds:      [],
        reactions:   [],
    };

    test('should accept valid search result with required fields', () => {
        const result = discordSearchResultSchema.safeParse(validSearchResult);
        expect(result.success).toBe(true);
    });

    test('should accept null guildId for DMs', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            guildId: null,
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.guildId).toBeNull();
        }
    });

    test('should accept optional fields when provided', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            replyTo:     '888777666555444333',
            attachments: [
                {
                    url:         'https://cdn.discordapp.com/attachments/123/456/file.png',
                    filename:    'file.png',
                    contentType: 'image/png',
                },
            ],
            embeds:    [{ title: 'Embed Title', description: 'Embed description' }],
            reactions: [{ emoji: '👍', count: 5 }],
        });
        expect(result.success).toBe(true);
    });

    test.each([
        ['id', { id: undefined }],
        ['channelId', { channelId: undefined }],
        ['author', { author: undefined }],
        ['content', { content: undefined }],
        ['timestamp', { timestamp: undefined }],
        ['attachments', { attachments: undefined }],
        ['embeds', { embeds: undefined }],
        ['reactions', { reactions: undefined }],
    ])('should require %s field', (_fieldName, override) => {
        const key = Object.keys(override)[0] as keyof typeof validSearchResult;
        const { [key]: _removed, ...incomplete } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(incomplete);
        expect(result.success).toBe(false);
    });

    test.each([
        ['id', { id: '' }],
        ['channelId', { channelId: '' }],
        ['timestamp', { timestamp: 'not-a-date' }],
    ])('should reject invalid %s', (_fieldName, override) => {
        const result = discordSearchResultSchema.safeParse({ ...validSearchResult, ...override });
        expect(result.success).toBe(false);
    });

    test('should accept empty content string', () => {
        const result = discordSearchResultSchema.safeParse({ ...validSearchResult, content: '' });
        expect(result.success).toBe(true);
    });
});

describe('overflowSummarySchema', () => {
    const validOverflow: OverflowSummary = {
        id:        '999888777666555444',
        timestamp: '2024-01-15T10:30:00.000Z',
        author:    'testuser',
        synopsis:  'User discussed the new feature implementation and mentioned several concerns about performance.',
    };

    test('should accept valid overflow summary', () => {
        const result = overflowSummarySchema.safeParse(validOverflow);
        expect(result.success).toBe(true);
    });

    test.each([
        ['id', { id: undefined }],
        ['timestamp', { timestamp: undefined }],
        ['author', { author: undefined }],
        ['synopsis', { synopsis: undefined }],
    ])('should require %s field', (_fieldName, override) => {
        const key = Object.keys(override)[0] as keyof typeof validOverflow;
        const { [key]: _removed, ...incomplete } = validOverflow;
        const result = overflowSummarySchema.safeParse(incomplete);
        expect(result.success).toBe(false);
    });

    test.each([
        ['id', { id: '' }],
        ['timestamp', { timestamp: 'not-a-date' }],
        ['author', { author: '' }],
        ['synopsis', { synopsis: '' }],
    ])('should reject invalid %s', (_fieldName, override) => {
        const result = overflowSummarySchema.safeParse({ ...validOverflow, ...override });
        expect(result.success).toBe(false);
    });
});

describe('batchOverflowSummarySchema', () => {
    const validBatch: BatchOverflowSummary = {
        startTimestamp: '2024-01-14T10:00:00.000Z',
        endTimestamp:   '2024-01-14T11:00:00.000Z',
        messageCount:   10,
        authors:        ['alice', 'bob'],
        synopsis:       'Discussion about deployment plans',
    };

    test('should accept valid batch summary', () => {
        const result = batchOverflowSummarySchema.safeParse(validBatch);
        expect(result.success).toBe(true);
    });

    test.each([
        ['startTimestamp', { startTimestamp: undefined }],
        ['endTimestamp', { endTimestamp: undefined }],
        ['messageCount', { messageCount: undefined }],
        ['authors', { authors: undefined }],
        ['synopsis', { synopsis: undefined }],
    ])('should require %s field', (_fieldName, override) => {
        const key = Object.keys(override)[0] as keyof typeof validBatch;
        const { [key]: _removed, ...incomplete } = validBatch;
        const result = batchOverflowSummarySchema.safeParse(incomplete);
        expect(result.success).toBe(false);
    });

    test.each([
        ['startTimestamp', { startTimestamp: 'not-a-date' }],
        ['endTimestamp', { endTimestamp: 'not-a-date' }],
        ['messageCount must be positive', { messageCount: 0 }],
        ['synopsis cannot be empty', { synopsis: '' }],
        ['authors cannot contain empty strings', { authors: [''] }],
    ])('should reject invalid %s', (_fieldName, override) => {
        const result = batchOverflowSummarySchema.safeParse({ ...validBatch, ...override });
        expect(result.success).toBe(false);
    });
});

describe('searchResponseSchema', () => {
    const validSearchResponse: SearchResponse = {
        messages: [
            {
                id:        '999888777666555444',
                channelId: '123456789012345678' as ChannelId,
                guildId:   '987654321098765432' as GuildId,
                author:    {
                    id:          '111222333444555666',
                    username:    'testuser',
                    displayName: 'Test User',
                },
                content:     'Hello, world!',
                timestamp:   '2024-01-15T10:30:00.000Z',
                attachments: [],
                embeds:      [],
                reactions:   [],
            },
        ],
        metadata: {
            totalFound: 1,
            timeRange:  {
                start: '2024-01-15T00:00:00.000Z',
                end:   '2024-01-15T23:59:59.999Z',
            },
        },
    };

    test('should accept valid search response', () => {
        const result = searchResponseSchema.safeParse(validSearchResponse);
        expect(result.success).toBe(true);
    });

    test('should accept search response with overflow and query', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:     50,
                summaries: [
                    {
                        id:        '888777666555444333',
                        timestamp: '2024-01-14T10:00:00.000Z',
                        author:    'otheruser',
                        synopsis:  'Earlier message summary',
                    },
                ],
            },
            metadata: {
                ...validSearchResponse.metadata,
                query: 'search term',
            },
        });
        expect(result.success).toBe(true);
    });

    test('should accept empty messages array', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            messages: [],
        });
        expect(result.success).toBe(true);
    });

    test.each([
        ['messages', { messages: undefined }],
        ['metadata', { metadata: undefined }],
    ])('should require %s field', (_fieldName, override) => {
        const key = Object.keys(override)[0] as keyof typeof validSearchResponse;
        const { [key]: _removed, ...incomplete } = validSearchResponse;
        const result = searchResponseSchema.safeParse(incomplete);
        expect(result.success).toBe(false);
    });

    test.each([
        ['metadata.totalFound', {
            metadata: {
                timeRange: validSearchResponse.metadata.timeRange,
            },
        }],
        ['metadata.timeRange', {
            metadata: {
                totalFound: 1,
            },
        }],
        ['metadata.timeRange.start', {
            metadata: {
                totalFound: 1,
                timeRange:  {
                    start: 'invalid',
                    end:   '2024-01-15T23:59:59.999Z',
                },
            },
        }],
        ['metadata.timeRange.end', {
            metadata: {
                totalFound: 1,
                timeRange:  {
                    start: '2024-01-15T00:00:00.000Z',
                    end:   'invalid',
                },
            },
        }],
    ])('should require valid %s', (_fieldName, override) => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            ...override,
        });
        expect(result.success).toBe(false);
    });

    test('should require overflow.count to be non-negative', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:     -1,
                summaries: [],
            },
        });
        expect(result.success).toBe(false);
    });

    test('should accept overflow.count of 0', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:     0,
                summaries: [],
            },
        });
        expect(result.success).toBe(true);
    });

    test('should accept search response with count-only overflow (no summaries)', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count: 50,
                hint:  'Use searchMessages with startTime/endTime to get AI summaries',
            },
        });
        expect(result.success).toBe(true);
    });

    test('should accept search response with batch summaries', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:          50,
                batchSummaries: [
                    {
                        startTimestamp: '2024-01-14T10:00:00.000Z',
                        endTimestamp:   '2024-01-14T11:00:00.000Z',
                        messageCount:   10,
                        authors:        ['alice', 'bob'],
                        synopsis:       'Discussion about deployment plans',
                    },
                ],
            },
        });
        expect(result.success).toBe(true);
    });

    test('should accept overflow with hasMore flag', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:   200,
                hasMore: true,
                hint:    'Narrow your search with startTime/endTime',
            },
        });
        expect(result.success).toBe(true);
    });

    test('should reject batch summary with empty synopsis', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:          10,
                batchSummaries: [
                    {
                        startTimestamp: '2024-01-14T10:00:00.000Z',
                        endTimestamp:   '2024-01-14T11:00:00.000Z',
                        messageCount:   10,
                        authors:        ['alice'],
                        synopsis:       '',
                    },
                ],
            },
        });
        expect(result.success).toBe(false);
    });

    test('should reject batch summary with invalid timestamp', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            overflow: {
                count:          10,
                batchSummaries: [
                    {
                        startTimestamp: 'not-a-date',
                        endTimestamp:   '2024-01-14T11:00:00.000Z',
                        messageCount:   10,
                        authors:        ['alice'],
                        synopsis:       'Summary',
                    },
                ],
            },
        });
        expect(result.success).toBe(false);
    });
});
