import { describe, test, expect } from 'bun:test';
import {
    discordSearchResultSchema,
    overflowSummarySchema,
    searchResponseSchema,
    type DiscordSearchResult,
    type OverflowSummary,
    type SearchResponse
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

    test('should accept valid search result with all required fields', () => {
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

    test('should accept search result with replyTo', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            replyTo: '888777666555444333',
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.replyTo).toBe('888777666555444333');
        }
    });

    test('should accept search result with attachments', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            attachments: [
                {
                    url:         'https://cdn.discordapp.com/attachments/123/456/file.png',
                    filename:    'file.png',
                    contentType: 'image/png',
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    test('should accept search result with embeds', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            embeds: [
                { title: 'Embed Title', description: 'Embed description' },
            ],
        });
        expect(result.success).toBe(true);
    });

    test('should accept search result with reactions', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            reactions: [
                { emoji: '👍', count: 5 },
                { emoji: '❤️', count: 3 },
            ],
        });
        expect(result.success).toBe(true);
    });

    test('should require id field', () => {
        const { id: _id, ...noId } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noId);
        expect(result.success).toBe(false);
    });

    test('should reject empty id', () => {
        const result = discordSearchResultSchema.safeParse({ ...validSearchResult, id: '' });
        expect(result.success).toBe(false);
    });

    test('should require channelId field', () => {
        const { channelId: _channelId, ...noChannelId } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noChannelId);
        expect(result.success).toBe(false);
    });

    test('should reject empty channelId', () => {
        const result = discordSearchResultSchema.safeParse({ ...validSearchResult, channelId: '' });
        expect(result.success).toBe(false);
    });

    test('should require author field', () => {
        const { author: _author, ...noAuthor } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noAuthor);
        expect(result.success).toBe(false);
    });

    test('should require content field', () => {
        const { content: _content, ...noContent } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noContent);
        expect(result.success).toBe(false);
    });

    test('should accept empty content string', () => {
        const result = discordSearchResultSchema.safeParse({ ...validSearchResult, content: '' });
        expect(result.success).toBe(true);
    });

    test('should require timestamp field', () => {
        const { timestamp: _timestamp, ...noTimestamp } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noTimestamp);
        expect(result.success).toBe(false);
    });

    test('should validate timestamp as ISO datetime', () => {
        const result = discordSearchResultSchema.safeParse({
            ...validSearchResult,
            timestamp: 'not-a-date',
        });
        expect(result.success).toBe(false);
    });

    test('should require attachments field', () => {
        const { attachments: _attachments, ...noAttachments } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noAttachments);
        expect(result.success).toBe(false);
    });

    test('should require embeds field', () => {
        const { embeds: _embeds, ...noEmbeds } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noEmbeds);
        expect(result.success).toBe(false);
    });

    test('should require reactions field', () => {
        const { reactions: _reactions, ...noReactions } = validSearchResult;
        const result = discordSearchResultSchema.safeParse(noReactions);
        expect(result.success).toBe(false);
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

    test('should require id field', () => {
        const { id: _id, ...noId } = validOverflow;
        const result = overflowSummarySchema.safeParse(noId);
        expect(result.success).toBe(false);
    });

    test('should reject empty id', () => {
        const result = overflowSummarySchema.safeParse({ ...validOverflow, id: '' });
        expect(result.success).toBe(false);
    });

    test('should require timestamp field', () => {
        const { timestamp: _timestamp, ...noTimestamp } = validOverflow;
        const result = overflowSummarySchema.safeParse(noTimestamp);
        expect(result.success).toBe(false);
    });

    test('should validate timestamp as ISO datetime', () => {
        const result = overflowSummarySchema.safeParse({
            ...validOverflow,
            timestamp: 'not-a-date',
        });
        expect(result.success).toBe(false);
    });

    test('should require author field', () => {
        const { author: _author, ...noAuthor } = validOverflow;
        const result = overflowSummarySchema.safeParse(noAuthor);
        expect(result.success).toBe(false);
    });

    test('should reject empty author', () => {
        const result = overflowSummarySchema.safeParse({ ...validOverflow, author: '' });
        expect(result.success).toBe(false);
    });

    test('should require synopsis field', () => {
        const { synopsis: _synopsis, ...noSynopsis } = validOverflow;
        const result = overflowSummarySchema.safeParse(noSynopsis);
        expect(result.success).toBe(false);
    });

    test('should reject empty synopsis', () => {
        const result = overflowSummarySchema.safeParse({ ...validOverflow, synopsis: '' });
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

    test('should accept valid search response without overflow', () => {
        const result = searchResponseSchema.safeParse(validSearchResponse);
        expect(result.success).toBe(true);
    });

    test('should accept valid search response with overflow', () => {
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
        });
        expect(result.success).toBe(true);
    });

    test('should accept search response with query in metadata', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: {
                ...validSearchResponse.metadata,
                query: 'search term',
            },
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata.query).toBe('search term');
        }
    });

    test('should accept empty messages array', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            messages: [],
        });
        expect(result.success).toBe(true);
    });

    test('should require messages field', () => {
        const { messages: _messages, ...noMessages } = validSearchResponse;
        const result = searchResponseSchema.safeParse(noMessages);
        expect(result.success).toBe(false);
    });

    test('should require metadata field', () => {
        const { metadata: _metadata, ...noMetadata } = validSearchResponse;
        const result = searchResponseSchema.safeParse(noMetadata);
        expect(result.success).toBe(false);
    });

    test('should require metadata.totalFound', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: {
                timeRange: validSearchResponse.metadata.timeRange,
            },
        });
        expect(result.success).toBe(false);
    });

    test('should require metadata.timeRange', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: {
                totalFound: 1,
            },
        });
        expect(result.success).toBe(false);
    });

    test('should require metadata.timeRange.start as ISO datetime', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: {
                totalFound: 1,
                timeRange:  {
                    start: 'invalid',
                    end:   '2024-01-15T23:59:59.999Z',
                },
            },
        });
        expect(result.success).toBe(false);
    });

    test('should require metadata.timeRange.end as ISO datetime', () => {
        const result = searchResponseSchema.safeParse({
            ...validSearchResponse,
            metadata: {
                totalFound: 1,
                timeRange:  {
                    start: '2024-01-15T00:00:00.000Z',
                    end:   'invalid',
                },
            },
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
});
